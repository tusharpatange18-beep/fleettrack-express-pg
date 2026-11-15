const { Router } = require('express');
const { validate } = require('../middleware/validate');
const schemas = require('../schemas');
const reports = require('../services/reportService');

module.exports = function reportRoutes() {
  const router = Router();

  router.get('/deliveries-per-driver', validate({ query: schemas.daysQuery }), async (req, res) => {
    res.json(await reports.deliveriesPerDriver(req.valid.query.days));
  });

  router.get('/vehicles-by-status', async (req, res) => {
    res.json(await reports.vehiclesByStatus());
  });

  return router;
};
