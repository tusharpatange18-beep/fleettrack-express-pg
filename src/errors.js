// One error class carrying an HTTP status. Services throw these; the error handler turns
// them into JSON responses. Services never touch `res` directly.
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const badRequest = message => new HttpError(400, message);
const unauthorized = message => new HttpError(401, message);
const forbidden = message => new HttpError(403, message);
const notFound = message => new HttpError(404, message);
const conflict = message => new HttpError(409, message);

module.exports = { HttpError, badRequest, unauthorized, forbidden, notFound, conflict };
