const { Router } = require('express');
const { validate } = require('../middleware/validate');
const { requireRole } = require('../middleware/auth');
const schemas = require('../schemas');
const drivers = require('../services/driverService');

// Dispatchers may read drivers (to plan assignments); only admins may change them.
module.exports = function driverRoutes() {
  const router = Router();
  const adminOnly = requireRole('ADMIN');

  router.get('/', validate({ query: schemas.pagination }), async (req, res) => {
    res.json(await drivers.list(req.valid.query));
  });

  router.get('/:id', validate({ params: schemas.idParam }), async (req, res) => {
    res.json(await drivers.get(req.valid.params.id));
  });

  router.post('/', adminOnly, validate({ body: schemas.driverCreate }), async (req, res) => {
    res.status(201).json(await drivers.create(req.valid.body));
  });

  router.patch('/:id', adminOnly, validate({ params: schemas.idParam, body: schemas.driverUpdate }), async (req, res) => {
    res.json(await drivers.update(req.valid.params.id, req.valid.body));
  });

  router.delete('/:id', adminOnly, validate({ params: schemas.idParam }), async (req, res) => {
    await drivers.remove(req.valid.params.id);
    res.status(204).end();
  });

  router.patch('/:driverId/assign-vehicle/:vehicleId', adminOnly, validate({ params: schemas.driverVehicleParams }),
    async (req, res) => {
      await drivers.assignVehicle(req.valid.params.driverId, req.valid.params.vehicleId);
      res.status(200).end();
    });

  router.delete('/:id/vehicle', adminOnly, validate({ params: schemas.idParam }), async (req, res) => {
    await drivers.unassignVehicle(req.valid.params.id);
    res.status(204).end();
  });

  return router;
};
