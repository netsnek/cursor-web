FROM node:20-bookworm-slim AS builder
ARG TARGETARCH
WORKDIR /build
COPY . .
RUN apt-get update && apt-get install -y python3 git curl squashfs-tools && rm -rf /var/lib/apt/lists/*
RUN EXTRACT_ARCH=$(echo "${TARGETARCH}" | sed 's/amd64/amd64/;s/arm64/arm64/') && \
    scripts/extract-cursor.sh latest "$EXTRACT_ARCH"
RUN BUILD_ARCH=$(echo "${TARGETARCH}" | sed 's/amd64/x64/;s/arm64/arm64/') && \
    scripts/build.sh "$BUILD_ARCH"

FROM node:20-bookworm-slim
RUN apt-get update && apt-get install -y git curl sudo openssh-client && rm -rf /var/lib/apt/lists/*
RUN useradd -m -s /bin/bash coder && echo "coder ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers

COPY --from=builder /build/dist /opt/cursor-web
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

USER coder
WORKDIR /home/coder
EXPOSE 20000
ENTRYPOINT ["/entrypoint.sh"]
