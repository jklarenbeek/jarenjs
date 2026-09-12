import { nodeProcessDriver, type ProcessSettlement } from '@jarenjs/db/node-process';

const processDriver = nodeProcessDriver({ maxOwners: 2, timeoutMs: 100, windowRows: 4 });
async function supervisedNativeQuery() {
  const owner = await processDriver.open('example.sqlite', { timeout: 50, queueTimeout: 100 });
  const noInterrupt: false = owner.capabilities.cancellation.midStatement;
  const processOwner: true = owner.capabilities.process;
  const result: number = await owner.supervise(async (connection) => {
    await connection.transaction(async (scope) => { await scope.exec('SELECT 1'); });
    return 7;
  }, { timeoutMs: 250, signal: new AbortController().signal });
  const fate: ProcessSettlement = owner.settlement();
  void [result, fate.safeToReplace, processDriver.metrics().quarantined, noInterrupt, processOwner];
  owner.cancel('request ended'); await owner.settled(); await owner.close();
}
void supervisedNativeQuery;
// @ts-expect-error admission is a numeric credit
nodeProcessDriver({ maxOwners: 'unbounded' });
