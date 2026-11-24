// New recordings never overwrite the preserved historical MP4/audio editions.
import {runLeaveBrowser} from './browser-scenario.mjs';
await runLeaveBrowser({record:true});
