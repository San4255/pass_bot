# pass_bot

## Installation & Setup (Single Command)

Copy and paste this single command in Termux:

```bash
pkg update && pkg upgrade -y && pkg install git -y && git clone https://github.com/San4255/pass_bot.git && cd pass_bot && bash setup.sh && echo "alias run='node pass_bot/pass.js'" >> ~/.bashrc && echo "alias setup='node pass_bot/config.js'" >> ~/.bashrc && source ~/.bashrc
```
if alias not working then copy and paste this command:

```bash
sed -i "s|node pass_bot/pass.js|node pass.js|; s|node pass_bot/config.js|node config.js|" ~/.bashrc && source ~/.bashrc
```

