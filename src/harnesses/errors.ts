export class ExplainerNotFoundError extends Error {}
export class ExplainerTimeoutError extends Error {}
export class ExplainerAbortedError extends Error {}
export class ExplainerRunError extends Error {
  constructor(message: string, readonly exitCode: number | null, readonly stderrTail: string) {
    super(message);
  }
}
