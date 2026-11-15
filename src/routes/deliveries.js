const { Router } = require('express');
const { validate } = require('../middleware/validate');
const schemas = require('../schemas');
const deliveries = require('../services/deliveryService');

module.exports = function deliveryRoutes(config) {
  const router = Router();

  router.get('/', validate({ query: schemas.pagination }), async (req, res) => {
    res.json(await deliveries.list(req.valid.query));
  });

  router.post('/', validate({ body: schemas.deliveryCreate }), async (req, res) => {
    res.status(201).json(await deliveries.create(req.valid.body));
  });

  router.get('/:id', validate({ params: schemas.idParam }), async (req, res) => {
    res.json(await deliveries.get(req.valid.params.id));
  });

  router.patch('/:id/assign', validate({ params: schemas.idParam, query: schemas.assignQuery }), async (req, res) => {
    res.json(await deliveries.assign(req.valid.params.id, req.valid.query.vehicleId));
  });

  router.post('/:id/auto-assign', validate({ params: schemas.idParam, query: schemas.autoAssignQuery }),
    async (req, res) => {
      const radiusKm = req.valid.query.radiusKm ?? config.autoAssignRadiusKm;
      res.json(await deliveries.autoAssign(req.valid.params.id, radiusKm, config));
    });

  router.patch('/:id/status', validate({ params: schemas.idParam, body: schemas.statusUpdate }), async (req, res) => {
    res.json(await deliveries.updateStatus(req.valid.params.id, req.valid.body.status));
  });

  return router;
};
