// New recordings never overwrite the preserved historical MP4/audio editions.
import {runLeaveBrowser} from './browser-scenario.ts';
await runLeaveBrowser({record:true});
