FROM node:20-alpine
WORKDIR /app
COPY . .
RUN npm install
EXPOSE 3000
CMD ["sh", "-c", "ls -la /app && node server.js"]
