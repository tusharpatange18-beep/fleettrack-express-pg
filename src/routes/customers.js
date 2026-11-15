const { Router } = require('express');
const { validate } = require('../middleware/validate');
const schemas = require('../schemas');
const customers = require('../services/customerService');

module.exports = function customerRoutes() {
  const router = Router();

  router.get('/', validate({ query: schemas.pagination }), async (req, res) => {
    res.json(await customers.list(req.valid.query));
  });

  router.post('/', validate({ body: schemas.customerCreate }), async (req, res) => {
    res.status(201).json(await customers.create(req.valid.body));
  });

  router.get('/:id', validate({ params: schemas.idParam }), async (req, res) => {
    res.json(await customers.get(req.valid.params.id));
  });

  return router;
};
