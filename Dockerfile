FROM node:20-bookworm-slim

# Install system dependencies: ffmpeg, python3, ca-certificates
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy dependency files
COPY package*.json ./

# Install npm packages
RUN npm install --omit=dev

# Copy application source
COPY . .

# Ensure bin and data directories exist
RUN mkdir -p bin data

ENV NODE_ENV=production

CMD ["npm", "start"]
