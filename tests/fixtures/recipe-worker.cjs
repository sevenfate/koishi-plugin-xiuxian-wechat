const { workerData, parentPort } = require('node:worker_threads')
if (workerData.herbs[0]?.id === -1) setInterval(() => {}, 100)
else if (workerData.herbs[0]?.id === -2) throw Error('fixture failure')
else { parentPort.postMessage({ recipes: [] }); parentPort.close() }
