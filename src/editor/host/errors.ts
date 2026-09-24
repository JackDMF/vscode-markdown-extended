/** What was thrown, as the one line a log entry or an error banner shows. */
export function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
