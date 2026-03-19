#!/bin/bash
node index.js > bot_run.log 2>&1 &
BOT_PID=$!
echo $BOT_PID > bot.pid
echo "Bot started with PID $BOT_PID. Waiting for 60 seconds..."
sleep 60
if ps -p $BOT_PID > /dev/null; then
    echo "Bot is still running. Killing it now."
    kill $BOT_PID
else
    echo "Bot has already exited."
fi
