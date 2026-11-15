const { Router } = require('express');
const { validate } = require('../middleware/validate');
const schemas = require('../schemas');
const vehicles = require('../services/vehicleService');

module.exports = function vehicleRoutes(config) {
  const router = Router();

  router.get('/', validate({ query: schemas.pagination }), async (req, res) => {
    res.json(await vehicles.list(req.valid.query));
  });

  // Declared before '/:id' so "nearby" is not treated as an id
  router.get('/nearby', validate({ query: schemas.nearbyQuery }), async (req, res) => {
    res.json(await vehicles.nearby(req.valid.query, config));
  });

  router.post('/', validate({ body: schemas.vehicleCreate }), async (req, res) => {
    res.status(201).json(await vehicles.create(req.valid.body));
  });

  router.get('/:id', validate({ params: schemas.idParam }), async (req, res) => {
    res.json(await vehicles.get(req.valid.params.id));
  });

  router.patch('/:id', validate({ params: schemas.idParam, body: schemas.vehicleUpdate }), async (req, res) => {
    res.json(await vehicles.update(req.valid.params.id, req.valid.body));
  });

  router.delete('/:id', validate({ params: schemas.idParam }), async (req, res) => {
    await vehicles.remove(req.valid.params.id);
    res.status(204).end();
  });

  router.patch('/:id/location', validate({ params: schemas.idParam, body: schemas.location }), async (req, res) => {
    res.json(await vehicles.updateLocation(req.valid.params.id, req.valid.body));
  });

  router.get('/:id/locations', validate({ params: schemas.idParam, query: schemas.historyQuery }), async (req, res) => {
    res.json(await vehicles.locationHistory(req.valid.params.id, req.valid.query));
  });

  return router;
};
