
# BestMessageLogger

**This is the first plugin that i made for vencord.
It's Basically The Better Version of MessageLogger Plugin in Vencord.
You Might wanna use Vencord Dev to use this plugin , otherwise you can't.**

<img width="1239" height="753" alt="image" src="https://github.com/user-attachments/assets/08485f5e-285c-4097-a9ab-f37157c30566" />

## Features:
* Deleted messages stay in chat, and come back after switching channels, reloading or restarting Discord
* Edit history shown inline, with a clickable "(edited)" history window
* Ghost ping logging (direct mentions, @everyone and your roles)
* Logs are saved on your computer and survive restarts
* Images, videos, audio and files of deleted messages are saved locally, so they still open after Discord removes them
* Hotkey-opened log menu (**Ctrl + Shift + I** by default)
* Messages look like they do in Discord: custom emojis, @mentions, roles, channels, timestamps, markdown, embeds, forwards and bot components
* Profile pictures, server names and server icons
* Search across messages, people, servers, channels and file names
* Separate Deleted / Edits / Ghost Pings tabs, All / Servers / DMs filters, servers grouped with their icon
* Edits show exactly which words changed
* Jump to message, copy text, remove single entries
* Keyboard navigation (arrow keys, Esc, Ctrl+F)
* Works on small windows too
* JSON export
* Custom ignore filters, retention, saved limit, media size limit and hotkey settings

## Install
1. Use an up to date [Vencord dev install](https://docs.vencord.dev/installing/custom-plugins/).
2. Put the `BestMessageLogger` folder in `src/userplugins`, then run `pnpm build` and inject or restart.
3. Turn off Vencord's built-in **MessageLogger**. Both patch the same parts of Discord and can't run together.

Built to feel lightweight, organized, and easy to use. Made by Kh8da, [kh8da.com](https://kh8da.com).
