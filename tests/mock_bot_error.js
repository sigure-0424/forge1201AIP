// mock_bot_error.js
console.log('Mock bot started.');
process.send({ type: 'LOG', data: 'Mock bot is running.' });

// Trigger an error after a short delay
setTimeout(() => {
    process.send({ type: 'ERROR', category: 'HandshakeTimeout', details: 'FML3 handshake timed out after 10s' });
}, 500);

// Keep alive for a bit
setTimeout(() => {
    process.exit(0);
}, 2000);
