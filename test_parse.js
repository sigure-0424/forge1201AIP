const fs = require('fs');

// Payload from test_fml.js
const hex1 = "ab 0c 05 2b 09 6d 69 6e 65 63 72 61 66 74 09 4d 69 6e 65 63 72 61 66 74 06 31 2e 32 30 2e 31 0d 73 69 6d 70 6c 65 62 61 63 6b 75 70 73 0e 53 69 6d 70";
const buf = Buffer.from(hex1.split(' ').map(x => parseInt(x, 16)));

console.log("Buffer length:", buf.length);
console.log("String representation:");
console.log(buf.toString('utf8'));
