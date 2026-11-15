module.exports = async function globalTeardown() {
  if (globalThis.__EMBEDDED_PG__) {
    await globalThis.__EMBEDDED_PG__.stop();
  }
};
