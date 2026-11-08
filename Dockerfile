FROM evernode/sashimono:hp.latest-ubt.20.04-njs.20
ENV DEBIAN_FRONTEND=noninteractive
RUN apt update && \
    apt install -y tzdata && \
    ln -fs /usr/share/zoneinfo/Etc/UTC /etc/localtime && \
    dpkg-reconfigure --frontend noninteractive tzdata && \
    apt install -y python curl && \
    curl -qL https://www.npmjs.com/install.sh | bash && \
    apt install -y openssh-server openssl sudo bash nano && \
    apt-get install -y supervisor && \
    mkdir -p /var/log/supervisor && \
    rm -rf /var/lib/apt/lists/*

RUN useradd -m -s /bin/bash everweb && \
    echo "everweb:default" | chpasswd && \
    usermod -aG sudo everweb && \
    echo "everweb ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers

RUN mkdir /var/run/sshd && \
    echo "Port 22" >> /etc/ssh/sshd_config && \
    echo "Port 36526" >> /etc/ssh/sshd_config && \
    echo "Port 36528" >> /etc/ssh/sshd_config && \
    echo "Port 36530" >> /etc/ssh/sshd_config && \
    echo "PermitRootLogin no" >> /etc/ssh/sshd_config && \
    echo "ListenAddress 0.0.0.0" >> /etc/ssh/sshd_config

COPY admin /home/everweb/admin
COPY COPYING /home/everweb/COPYING
COPY README.md /home/everweb/README.md
COPY node_modules /home/everweb/node_modules
COPY index.js /home/everweb/index.js
COPY dynamic-endpoints.js /home/everweb/dynamic-endpoints.js
COPY dynamic-endpoints-data.json /home/everweb/dynamic-endpoints-data.json
COPY settings.json /home/everweb/settings.json
COPY morefunctions.json /home/everweb/morefunctions.json
COPY extra-modules.json /home/everweb/extra-modules.json
COPY extra-vars.json /home/everweb/extra-vars.json
COPY package-lock.json /home/everweb/package-lock.json
COPY package.json /home/everweb/package.json
COPY sidedish.js /home/everweb/sidedish.js
COPY public /home/everweb/public
COPY first-run-setup.js /home/everweb/first-run-setup.js
COPY contract/dist/ /home/everweb/contract/
COPY start.sh /start.sh
COPY supervisord.conf /home/everweb/supervisord.conf
RUN chmod +x /start.sh
WORKDIR /home/everweb
ENTRYPOINT ["/start.sh"]