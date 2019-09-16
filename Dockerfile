FROM alpine:edge as game
RUN apk add --update --no-cache build-base clang make
WORKDIR /app
COPY mm25_game_engine ./mm25_game_engine
RUN cd mm25_game_engine && make

FROM mhart/alpine-node:10 as base
WORKDIR /usr/src
COPY package.json yarn.lock /usr/src/
RUN yarn --production
COPY . .

FROM mhart/alpine-node:base-10
RUN apk add --update --no-cache docker libstdc++ libgcc
WORKDIR /usr/src
ENV NODE_ENV="production"
COPY --from=game /app/mm2018 /game
COPY --from=base /usr/src .
CMD ["node", "index.js"]