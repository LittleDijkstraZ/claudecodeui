import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { createRemoteHub } from './modules/remote-hub/index.js';

const configPath = process.argv[2];
if (!configPath) throw new Error('Usage: node dist-server/server/remote-hub.js /absolute/path/hub.json');
const config = JSON.parse(readFileSync(resolve(configPath), 'utf8'));
if (typeof config.dist !== 'string' || typeof config.stateDirectory !== 'string') throw new Error('Hub dist and stateDirectory paths are required');
const hub = createRemoteHub(config);
hub.server.listen(config.port, '127.0.0.1', () => console.log(`CloudCLI remote hub: http://127.0.0.1:${config.port} (remote execution only)`));
process.on('SIGTERM', hub.close);
process.on('SIGINT', hub.close);
