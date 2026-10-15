// Prints a HUNT_CODES value with a new random code for every checkpoint.
import config from '../hunt.config.js';
import { makeCodes } from '../src/codes.js';

console.log(`HUNT_CODES=${makeCodes(config)}`);
