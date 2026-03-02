FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      openssh-server \
      openssh-client \
      sudo \
      curl \
      ca-certificates \
      apt-transport-https \
      systemctl \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /run/sshd

# Allow root login via public key only
RUN sed -i 's/#PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config && \
    sed -i 's/#PubkeyAuthentication.*/PubkeyAuthentication yes/' /etc/ssh/sshd_config && \
    sed -i 's/#PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config

RUN mkdir -p /root/.ssh && chmod 700 /root/.ssh

# Ensure host keys exist (regenerate if missing)
RUN ssh-keygen -A

EXPOSE 22

CMD ["/usr/sbin/sshd", "-D", "-e"]
