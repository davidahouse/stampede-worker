# Dockerfile

# node image
FROM node:8
# working folder
WORKDIR /var/stampede
# install app dependencies
COPY package*.json ./
RUN npm install
# copy the app into the container
COPY . .
# run the server
CMD ["node", "bin/stampede-worker.js"]