FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
ENV NODE_OPTIONS="--experimental-vm-modules --no-warnings"

# Enable non-free/contrib repos, upgrade, and install packages in one layer
RUN apt-get update \
    && apt-get install -y --no-install-recommends software-properties-common \
    && add-apt-repository -y non-free contrib \
    && apt-get update \
    && apt-get upgrade -y \
    && apt-get install -y --no-install-recommends \
        curl \
        git-lfs \
        iputils-ping \
        jq \
        pipx \
        sudo \
        wget \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user with passwordless sudo
RUN groupadd --gid 1000 dev \
    && useradd --uid 1000 --gid 1000 --shell /bin/bash --create-home dev \
    && echo "dev ALL=(root) NOPASSWD:ALL" > /etc/sudoers.d/dev \
    && chmod 0440 /etc/sudoers.d/dev

USER dev
ENV HOME=/home/dev
ENV PATH="$HOME/.yarn/bin:$HOME/.local/bin:${PATH}"

# Ensure ~/.local/bin is in PATH for interactive shell sessions
RUN echo 'export PATH="$HOME/.local/bin:$PATH"' >> /home/dev/.bashrc