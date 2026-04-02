import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@mariozechner/pi-tui";
import { getReviewWindowData, loadReviewFileContents } from "./git.js";
import { composeReviewPrompt } from "./prompt.js";
import { startReviewServer, type ReviewSession } from "./server.js";
import type {
  ReviewCancelPayload,
  ReviewFile,
  ReviewFileContents,
  ReviewHostMessage,
  ReviewRequestFilePayload,
  ReviewSubmitPayload,
  ReviewWindowMessage,
} from "./types.js";

function isSubmitPayload(value: ReviewWindowMessage): value is ReviewSubmitPayload {
  return value.type === "submit";
}

function isCancelPayload(value: ReviewWindowMessage): value is ReviewCancelPayload {
  return value.type === "cancel";
}

function isRequestFilePayload(value: ReviewWindowMessage): value is ReviewRequestFilePayload {
  return value.type === "request-file";
}

type WaitingEditorResult = "escape" | "window-settled";

export default function (pi: ExtensionAPI) {
  let activeSession: ReviewSession | null = null;
  let activeWaitingUIDismiss: (() => void) | null = null;

  function closeActiveSession(): void {
    if (activeSession == null) return;
    const session = activeSession;
    activeSession = null;
    try {
      session.close();
    } catch {}
  }

  function showWaitingUI(ctx: ExtensionCommandContext, session: ReviewSession): {
    promise: Promise<WaitingEditorResult>;
    dismiss: () => void;
  } {
    let settled = false;
    let doneFn: ((result: WaitingEditorResult) => void) | null = null;
    let pendingResult: WaitingEditorResult | null = null;

    const finish = (result: WaitingEditorResult): void => {
      if (settled) return;
      settled = true;
      if (activeWaitingUIDismiss === dismiss) {
        activeWaitingUIDismiss = null;
      }
      if (doneFn != null) {
        doneFn(result);
      } else {
        pendingResult = result;
      }
    };

    const promise = ctx.ui.custom<WaitingEditorResult>((_tui, theme, _kb, done) => {
      doneFn = done;
      if (pendingResult != null) {
        const result = pendingResult;
        pendingResult = null;
        queueMicrotask(() => done(result));
      }

      return {
        render(width: number): string[] {
          const innerWidth = Math.max(24, width - 2);
          const borderTop = theme.fg("border", `╭${"─".repeat(innerWidth)}╮`);
          const borderBottom = theme.fg("border", `╰${"─".repeat(innerWidth)}╯`);
          const lines = [
            theme.fg("accent", theme.bold("Waiting for review")),
            `Open review UI: ${session.url}`,
            "",
            `ssh -L ${session.port}:127.0.0.1:${session.port} user@remote`,
            "",
            "Press Escape to cancel.",
          ];
          return [
            borderTop,
            ...lines.map((line) => `${theme.fg("border", "│")}${truncateToWidth(line, innerWidth, "...", true).padEnd(innerWidth, " ")}${theme.fg("border", "│")}`),
            borderBottom,
          ];
        },
        handleInput(data: string): void {
          if (matchesKey(data, Key.escape)) {
            finish("escape");
          }
        },
        invalidate(): void {},
      };
    });

    const dismiss = (): void => {
      finish("window-settled");
    };

    activeWaitingUIDismiss = dismiss;

    return {
      promise,
      dismiss,
    };
  }

  async function reviewRepository(ctx: ExtensionCommandContext): Promise<void> {
    if (activeSession != null) {
      ctx.ui.notify("A review session is already active.", "warning");
      return;
    }

    const { repoRoot, files } = await getReviewWindowData(pi, ctx.cwd);
    if (files.length === 0) {
      ctx.ui.notify("No reviewable files found.", "info");
      return;
    }

    const fileMap = new Map(files.map((file) => [file.id, file]));
    const contentCache = new Map<string, Promise<ReviewFileContents>>();

    // Terminal message settlement
    let settleTerminal: ((value: ReviewSubmitPayload | ReviewCancelPayload | null) => void) | null = null;
    const terminalPromise = new Promise<ReviewSubmitPayload | ReviewCancelPayload | null>((resolve) => {
      settleTerminal = resolve;
    });

    const loadContents = (file: ReviewFile, scope: ReviewRequestFilePayload["scope"]): Promise<ReviewFileContents> => {
      const key = `${scope}:${file.id}`;
      const cached = contentCache.get(key);
      if (cached != null) return cached;
      const pending = loadReviewFileContents(pi, repoRoot, file, scope);
      contentCache.set(key, pending);
      return pending;
    };

    const sendMessage = (message: ReviewHostMessage): void => {
      if (activeSession == null) return;
      activeSession.send(message);
    };

    const handleRequestFile = async (message: ReviewRequestFilePayload): Promise<void> => {
      const file = fileMap.get(message.fileId);
      if (file == null) {
        sendMessage({
          type: "file-error",
          requestId: message.requestId,
          fileId: message.fileId,
          scope: message.scope,
          message: "Unknown file requested.",
        });
        return;
      }

      try {
        const contents = await loadContents(file, message.scope);
        sendMessage({
          type: "file-data",
          requestId: message.requestId,
          fileId: message.fileId,
          scope: message.scope,
          originalContent: contents.originalContent,
          modifiedContent: contents.modifiedContent,
        });
      } catch (error) {
        const messageText = error instanceof Error ? error.message : String(error);
        sendMessage({
          type: "file-error",
          requestId: message.requestId,
          fileId: message.fileId,
          scope: message.scope,
          message: messageText,
        });
      }
    };

    const onBrowserMessage = (message: ReviewWindowMessage): void => {
      if (isRequestFilePayload(message)) {
        void handleRequestFile(message);
        return;
      }
      if (isSubmitPayload(message) || isCancelPayload(message)) {
        if (settleTerminal != null) {
          const fn = settleTerminal;
          settleTerminal = null;
          fn(message);
        }
      }
    };

    let session: ReviewSession;
    try {
      session = await startReviewServer({ repoRoot, files }, onBrowserMessage);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Failed to start review server: ${msg}`, "error");
      return;
    }

    activeSession = session;

    ctx.ui.notify(`Review server started on port ${session.port}.`, "info");

    const waitingUI = showWaitingUI(ctx, session);

    try {
      // Also settle on server session timeout/close
      const serverResult = session.waitForResult().then((msg) => {
        if (msg != null && (isSubmitPayload(msg) || isCancelPayload(msg))) {
          if (settleTerminal != null) {
            const fn = settleTerminal;
            settleTerminal = null;
            fn(msg);
          }
        }
        return { type: "server" as const, message: msg };
      });

      const result = await Promise.race([
        terminalPromise.then((message) => ({ type: "terminal" as const, message })),
        waitingUI.promise.then((reason) => ({ type: "ui" as const, reason })),
        serverResult,
      ]);

      if (result.type === "ui" && result.reason === "escape") {
        closeActiveSession();
        ctx.ui.notify("Review cancelled.", "info");
        return;
      }

      const message = result.type === "terminal" ? result.message : result.type === "server" ? result.message : await terminalPromise;

      waitingUI.dismiss();
      await waitingUI.promise;
      closeActiveSession();

      if (message == null || message.type === "cancel") {
        ctx.ui.notify("Review cancelled.", "info");
        return;
      }

      const prompt = composeReviewPrompt(files, message as ReviewSubmitPayload);
      ctx.ui.setEditorText(prompt);
      ctx.ui.notify("Inserted review feedback into the editor.", "info");
    } catch (error) {
      activeWaitingUIDismiss?.();
      closeActiveSession();
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Review failed: ${message}`, "error");
    }
  }

  pi.registerCommand("diff-review", {
    description: "Start a review server for git diff, last commit, and all files scopes",
    handler: async (_args, ctx) => {
      await reviewRepository(ctx);
    },
  });

  pi.on("session_shutdown", async () => {
    activeWaitingUIDismiss?.();
    closeActiveSession();
  });
}
