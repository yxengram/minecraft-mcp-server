// BLUEPRINT E-055 (1): the unit tests never use a real OpenRouter key and never reach the network, also when the
// shell that runs `npm test` has OPENROUTER_API_KEY. ava loads this file (package.json "ava.require") in every worker
// before the test files, so a client that reads the key from the environment finds none, and a request that was not
// given a fake fetch fails the test file: the rejection may be caught by the code under test, the uncaught exception
// thrown next to it is not. It is thrown through the real setImmediate, kept here before any test runs: sinon's fake
// timers replace the global one (and nextTick and queueMicrotask too), and a test that never ticks would never throw.

delete process.env.OPENROUTER_API_KEY;

const throwSoon = setImmediate;

const noNetwork = (input: unknown) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : String((input as { url?: unknown })?.url ?? input);
  const error = new Error(`unit tests make no network requests; give the code under test a fake fetch (fetch ${url})`);
  throwSoon(() => { throw error; });
  return Promise.reject(error);
};
// tests/release.test.ts checks that this file was loaded.
globalThis.fetch = Object.assign(noNetwork, { noNetwork: true }) as unknown as typeof fetch;
