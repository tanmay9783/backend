FROM node:20-slim

# Install ffmpeg
RUN apt-get update && apt-get install -y ffmpeg wget unzip && rm -rf /var/lib/apt/lists/*

# Install Rhubarb Lip Sync (Linux binary)
RUN wget -q https://github.com/DanielSWolf/rhubarb-lip-sync/releases/download/v1.13.0/Rhubarb-Lip-Sync-1.13.0-Linux.zip \
    -O /tmp/rhubarb.zip \
    && unzip /tmp/rhubarb.zip -d /opt/rhubarb \
    && chmod +x /opt/rhubarb/rhubarb \
    && rm /tmp/rhubarb.zip

ENV RHUBARB_PATH=/opt/rhubarb/rhubarb
ENV FFMPEG_PATH=ffmpeg

WORKDIR /app
COPY package*.json ./
RUN npm install --production

COPY . .

# Create audios folder
RUN mkdir -p audios

EXPOSE 3125
CMD ["npm", "start"]
