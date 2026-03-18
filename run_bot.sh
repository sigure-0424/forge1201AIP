// run_bot.sh
node index.js > bot_run.log 2>&1 &
echo $! > bot.pid
echo "Bot started with PID $(cat bot.pid)"
sleep 60
if ps -p $(cat bot.pid) > /dev/null; then
    echo "Bot is still running. Killing it now."
    kill $(cat bot.pid)
else
    echo "Bot has already exited."
fi
