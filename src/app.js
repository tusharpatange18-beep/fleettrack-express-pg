const express = require('express');
const db = require('./db/pool');
const { authenticate, requireRole } = require('./middleware/auth');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');
const reports = require('./services/reportService');

/**
 * Builds the Express app without starting a server. server.js calls listen(); tests pass the app
 * straight to supertest, which needs no open port.
 */
function createApp(config) {
  const app = express();
  app.disable('x-powered-by'); // don't advertise the framework
  app.use(express.json({ limit: '100kb' }));

  // Health check for load balancers: also proves the database answers
  app.get('/health', async (req, res) => {
    await db.query('SELECT 1');
    res.json({ status: 'UP' });
  });

  app.use('/api/auth', require('./routes/auth')(config));

  // Everything below needs a valid token, and one of the two roles
  const staff = [authenticate(config.jwtSecret), requireRole('ADMIN', 'DISPATCHER')];
  app.use('/api/vehicles', staff, require('./routes/vehicles')(config));
  app.use('/api/drivers', staff, require('./routes/drivers')(config));
  app.use('/api/customers', staff, require('./routes/customers')(config));
  app.use('/api/deliveries', staff, require('./routes/deliveries')(config));
  app.use('/api/reports', staff, require('./routes/reports')(config));
  app.get('/api/dashboard/summary', staff, async (req, res) => {
    res.json(await reports.dashboardSummary());
  });

  app.use(notFoundHandler);
  app.use(errorHandler); // must be registered last
  return app;
}

module.exports = { createApp };
