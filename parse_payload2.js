const fs = require('fs');

const hex1 = "ab 0c 05 2b 09 6d 69 6e 65 63 72 61 66 74 09 4d 69 6e 65 63 72 61 66 74 06 31 2e 32 30 2e 31 0d 73 69 6d 70 6c 65 62 61 63 6b 75 70 73 0e 53 69 6d 70";
const buf = Buffer.from(hex1.split(' ').map(x => parseInt(x, 16)));

function readVarInt(buffer, offset) {
    let numRead = 0;
    let result = 0;
    let read;
    do {
        read = buffer.readUInt8(offset + numRead);
        let value = (read & 0b01111111);
        result |= (value << (7 * numRead));
        numRead++;
        if (numRead > 5) {
            throw new Error('VarInt is too big');
        }
    } while ((read & 0b10000000) != 0);
    return { value: result, bytesRead: numRead };
}

let offset = 0;
const { value: varint1, bytesRead: br1 } = readVarInt(buf, offset);
offset += br1;
console.log("VarInt1 (maybe length?):", varint1);

const { value: varint2, bytesRead: br2 } = readVarInt(buf, offset);
offset += br2;
console.log("VarInt2 (maybe discriminator?):", varint2);

// Let's assume it's a list. 
// 05 is discriminator?
const { value: varint3, bytesRead: br3 } = readVarInt(buf, offset);
offset += br3;
console.log("VarInt3 (maybe list size?):", varint3);

// 43 = list size? Yes, 43 is decimal for 2b hex! 43 mods.
console.log("Remaining is mod data...");

