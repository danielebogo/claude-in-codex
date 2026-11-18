/** A local transport failure with an HTTP status safe to return to the client. */
export class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'RequestError';
    this.status = status;
  }
}
