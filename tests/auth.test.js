const request = require('supertest');
const { setupTestApp, client, adminToken, dispatcherToken } = require('./helpers');

const ctx = setupTestApp();

describe('registration and login', () => {
  test('the first account may register as ADMIN', async () => {
    const res = await request(ctx.app).post('/api/auth/register')
      .send({ username: 'boss', password: 'boss-password', role: 'ADMIN' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ username: 'boss', role: 'ADMIN' });
    expect(res.body.password_hash).toBeUndefined();
  });

  test('after that, an anonymous caller cannot create an ADMIN', async () => {
    await adminToken(ctx.app);
    const res = await request(ctx.app).post('/api/auth/register')
      .send({ username: 'eve', password: 'eve-password', role: 'ADMIN' });
    expect(res.status).toBe(403);
  });

  test('an admin can create another admin', async () => {
    const token = await adminToken(ctx.app);
    const res = await client(ctx.app, token).post('/api/auth/register',
      { username: 'second', password: 'second-password', role: 'admin' });
    expect(res.status).toBe(201);
    expect(res.body.role).toBe('ADMIN');
  });

  test('role defaults to DISPATCHER', async () => {
    await adminToken(ctx.app);
    const res = await request(ctx.app).post('/api/auth/register').send({ username: 'disp', password: 'disp-password' });
    expect(res.body.role).toBe('DISPATCHER');
  });

  test('weak passwords and odd usernames are rejected with 400', async () => {
    const shortPw = await request(ctx.app).post('/api/auth/register').send({ username: 'abc', password: '123' });
    expect(shortPw.status).toBe(400);
    const badName = await request(ctx.app).post('/api/auth/register').send({ username: 'a b', password: 'long-enough' });
    expect(badName.status).toBe(400);
  });

  test('duplicate username is 409', async () => {
    await adminToken(ctx.app);
    const res = await request(ctx.app).post('/api/auth/register').send({ username: 'admin', password: 'another-pass' });
    expect(res.status).toBe(409);
  });

  test('wrong password and unknown user give the same 401', async () => {
    await adminToken(ctx.app);
    const wrong = await request(ctx.app).post('/api/auth/login').send({ username: 'admin', password: 'nope-nope' });
    const unknown = await request(ctx.app).post('/api/auth/login').send({ username: 'ghost', password: 'nope-nope' });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.message).toBe(unknown.body.message);
  });

  test('passwords are stored as bcrypt hashes, never in plain text', async () => {
    await adminToken(ctx.app);
    const db = require('../src/db/pool');
    const { rows } = await db.query("SELECT password_hash FROM users WHERE username = 'admin'");
    expect(rows[0].password_hash).toMatch(/^\$2[aby]\$10\$/);
  });
});

describe('authentication and roles', () => {
  test('no token -> 401 with the JSON error shape', async () => {
    const res = await request(ctx.app).get('/api/vehicles');
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ status: 401, error: 'Unauthorized', path: '/api/vehicles' });
  });

  test('garbage or tampered token -> 401', async () => {
    const token = await adminToken(ctx.app);
    expect((await client(ctx.app, 'not-a-jwt').get('/api/vehicles')).status).toBe(401);
    expect((await client(ctx.app, token.slice(0, -2) + 'xx').get('/api/vehicles')).status).toBe(401);
  });

  test('dispatcher can read drivers but not create them (403)', async () => {
    const dispatcher = await dispatcherToken(ctx.app, await adminToken(ctx.app));
    const api = client(ctx.app, dispatcher);
    expect((await api.get('/api/drivers')).status).toBe(200);
    const res = await api.post('/api/drivers', { name: 'D', phone: '9876543210', licenseNumber: 'L1' });
    expect(res.status).toBe(403);
  });

  test('a token stops working when its user is deleted', async () => {
    const token = await adminToken(ctx.app);
    const db = require('../src/db/pool');
    await db.query('DELETE FROM users');
    expect((await client(ctx.app, token).get('/api/vehicles')).status).toBe(401);
  });

  test('unknown routes are 404 and the health check is public', async () => {
    const token = await adminToken(ctx.app);
    expect((await client(ctx.app, token).get('/api/nothing-here')).status).toBe(404);
    expect((await request(ctx.app).get('/health')).body).toEqual({ status: 'UP' });
  });
});
