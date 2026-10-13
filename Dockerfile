FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
ENV NODE_ENV=production DATA_DIR=/app/data
VOLUME /app/data
EXPOSE 3000
CMD ["npm", "start"]
