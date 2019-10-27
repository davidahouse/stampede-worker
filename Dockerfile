# Dockerfile

# arguments
ARG configPath
# node image
FROM node:8
# working folder
WORKDIR /var/stampede
# install app dependencies
COPY package*.json ./
RUN npm install
# copy the app into the container
COPY . .
COPY $configPath ./config
# setup the environment variables
ENV stampede_stampedeConfigPath /var/stampede/config
# run the server
CMD ["node", "bin/stampede-worker.js"]