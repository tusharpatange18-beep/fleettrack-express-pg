const { badRequest } = require('../errors');

/**
 * Validates req.body / req.query / req.params against zod schemas.
 * On success the parsed (and type-converted) values are stored on req.valid, so handlers never
 * read unvalidated input. On failure: 400 with every problem listed.
 *
 * Usage: router.post('/', validate({ body: vehicleCreate }), handler)
 */
function validate(schemas) {
  return (req, res, next) => {
    req.valid = {};
    for (const part of ['params', 'query', 'body']) {
      if (!schemas[part]) continue;
      const result = schemas[part].safeParse(req[part] ?? {});
      if (!result.success) {
        const message = result.error.issues
          .map(issue => `${issue.path.join('.') || part}: ${issue.message}`)
          .join('; ');
        throw badRequest(message);
      }
      req.valid[part] = result.data;
    }
    next();
  };
}

module.exports = { validate };
