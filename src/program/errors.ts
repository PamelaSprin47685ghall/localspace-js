export class ProgramError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ProgramError";
  }
}

export function isProgramError(error: unknown): error is ProgramError {
  return error instanceof ProgramError;
}
