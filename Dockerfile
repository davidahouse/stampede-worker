ARG config
FROM node:8
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm install
COPY . .
COPY $config /user/src/app/.stampederc 
CMD [ "npm", "start" ]