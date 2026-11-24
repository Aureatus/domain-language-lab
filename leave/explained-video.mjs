import {runLeaveBrowser} from './browser-scenario.mjs';
await runLeaveBrowser({explain:true,record:!process.argv.includes('--test')});
