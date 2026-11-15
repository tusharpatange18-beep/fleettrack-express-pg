const { Router } = require('express');
const { validate } = require('../middleware/validate');
const { authenticate } = require('../middleware/auth');
const schemas = require('../schemas');
const authService = require('../services/authService');

module.exports = function authRoutes(config) {
  const router = Router();

  // Public, but if a token is sent we read it: an admin may create other admins
  router.post('/register',
    authenticate(config.jwtSecret, { optional: true }),
    validate({ body: schemas.register }),
    async (req, res) => {
      const user = await authService.register(req.valid.body, req.user);
      res.status(201).json(user);
    });

  router.post('/login', validate({ body: schemas.login }), async (req, res) => {
    res.json(await authService.login(req.valid.body, config));
  });

  return router;
};
