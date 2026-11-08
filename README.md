here is a githubed webcbuilder, as requested by the author here ... 
https://evernode.forum/viewtopic.php?t=101
i (gadget78/mick) will keep this maintained here, 
as i use this within the evernode.app/evrPanel.net environments
please use the issue tracker here or on the linked evernode.forum site.


This code is available for anyone to fork, white-label, improve or change!
And please, someone, make a github for this :) __done__


# webcbuilder
This is a web cluster builder that is utilizing Evernode. With this software you can easily merge instances into a cluster, work on a smart contract in real time, upload a front-end to your evernode deployment and much more.

# Deploy Quickly To Evernode
This builder exist on the docker hub, you can deploy it with image everweb/webcbuilder:latest OR, if you need ssh access on gptcp2, everweb/webcbuilder-ssh:latest the ssl certificate and port is handled automatically if there's an env.vars file. If there isn't one, then the frontend runs on port 36525, 36527, 36529 and ssh (if used) on 36526, 36528 and 36530.

SSH user and password: everweb:default

# First login (admin password)
There is no default admin password. A new copy refuses every admin login until a password is set:
1. Get the one-time setup code: open your instance's **Docker Logs** in your Evernode panel (evernode.app or the host panel). The code is printed there once, the first time the container starts, and saved in `setup-code.txt` next to `index.js`. The code works like a key: anyone who can read those logs or that file can set the password.
2. Open `/admin/`, enter the code, and pick a password (12 characters or more).
If Docker Logs say `[setup] Setup step failed`, admin stays locked (it never falls back to an open login). Use **Docker restart** in your panel to run the setup step again.
3. While an admin password exists the code is refused. Passwords must be 12 characters or more, here and in User Management.

Copies still on the old default password (`password`) go back to setup mode after updating.

Remember to turn off ssh in supervisord.conf for your docker container!

The idea with this project is that it constantly keeps getting improved, anyone is welcome to contribute and fork this, anyone is welcome to whitelabel and "steal" the code. The intention behind this builder is that YOU can use it in any (legal of course) way you wish.

# How it generally works
This software use supervisord to run hotpocket, sshd(if used) and a nodejs server for the frontend.

The smart contract is syncapp.js (compiled into an index.js) and it loops through the "sidedish". What you add to the sidedish from the front end will be a part of the hotpocket smartcontract. This allows you to work on your smart contract application in real-time.

A youtube video showcasing the builder can be found below:
https://www.youtube.com/watch?v=TYOCalPWhlE

# What you need to do if you want to create your own docker container with this system
You need to browse into the main folder and write npm i, after that you need to enter the contract folder and write npm i as-well. That command will create the node_modules folder, which are needed.

When you got those folders, go to the main folder and use following commands to get your system to docker:
docker build -t youruseraccount/yourdockerimagename -f ./Dockerfile .
docker image push --all-tags youruseraccount/yourdockerimagename

# To learn more about evernode or contribute in the community, find us at:
https://evernode.forum
https://discord.gg/DAQszjKEBV
https://github.com/EvernodeXRPL
https://t.me/EvernodeCommunity/

# Know Issues:
Sometimes it doesn't work to activate a freshly installed npm package.