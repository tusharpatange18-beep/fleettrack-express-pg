const { badRequest } = require('../errors');

/**
 * Validates req.body / req.query / req.params against zod schemas.
 * On success the parsed (and type-converted) values are stored on req.valid, so handlers never
 * read unvalidated input. On failure: 400 with every problem listed.
 *
 * Usage: router.post('/', validate({ body: vehicleCreate }), handler)
 */
function validate(schemas) {
  // Express calls this function for every request on the route
  return function checkRequest(req, res, next) {
    req.valid = {};

    for (const part of ['params', 'query', 'body']) {
      const schema = schemas[part];
      if (!schema) {
        continue; // this route does not check this part
      }

      // A missing part (e.g. no body) is checked as an empty object
      let input = req[part];
      if (input === undefined || input === null) {
        input = {};
      }

      // safeParse never throws: it returns { success, data } or { success, error }
      const result = schema.safeParse(input);
      if (!result.success) {
        throw badRequest(describeProblems(result.error.issues, part));
      }
      req.valid[part] = result.data;
    }

    next(); // everything is valid: go on to the route handler
  };
}

/** Turns zod's list of problems into one message, e.g. "latitude: Too big; type: Invalid option". */
function describeProblems(issues, part) {
  const messages = [];
  for (const issue of issues) {
    // issue.path is the field name, e.g. ['pickupLatitude']; empty means the whole object
    let field = issue.path.join('.');
    if (field === '') {
      field = part;
    }
    messages.push(field + ': ' + issue.message);
  }
  return messages.join('; ');
}

module.exports = { validate };
