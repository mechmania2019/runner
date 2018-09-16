FROM alpine:edge as game
RUN apk add --update --no-cache build-base clang make
WORKDIR /app
COPY mm2018 ./mm2018
RUN cd mm2018 && make

FROM mhart/alpine-node:10 as base
WORKDIR /usr/src
COPY package.json yarn.lock /usr/src/
RUN yarn --production
COPY . .

FROM mhart/alpine-node:base-10
RUN apk add --update --no-cache python
WORKDIR /usr/src
ENV NODE_ENV="production"
COPY --from=base /usr/src .
COPY --from=game /app/mm2018 ./game
CMD ["node", "index.js"]