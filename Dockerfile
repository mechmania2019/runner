FROM openjdk:14-alpine as java

FROM alpine:edge as game
RUN apk add --update --no-cache build-base clang make
WORKDIR /app
COPY mm25_game_engine ./mm25_game_engine
# RUN cd mm25_game_engine && make

FROM mhart/alpine-node:10 as base
WORKDIR /usr/src
COPY package.json yarn.lock /usr/src/
RUN yarn --production
COPY . .

FROM mhart/alpine-node:base-10
RUN apk add --update --no-cache libstdc++ libgcc
WORKDIR /usr/src
ENV NODE_ENV="production"
COPY --from=java /opt/openjdk-14 /opt/openjdk-14
ENV PATH /opt/openjdk-14/bin:$PATH
COPY --from=game /app/mm25_game_engine /game
COPY --from=base /usr/src .
CMD ["node", "index.js"]