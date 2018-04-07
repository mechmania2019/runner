FROM ubuntu:16.04

RUN apt update
RUN apt install -y build-essential
RUN apt install -y clang
RUN apt install -y libc++-dev

WORKDIR /app
COPY . .

RUN cd mm2018 && make

CMD [ "/bin/bash" ]