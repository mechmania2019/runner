const { promisify } = require("util");

const mongoose = require("mongoose");
const AWS = require("aws-sdk");
const fs = require("fs");
const path = require("path");
const rimraf = promisify(require("rimraf"));
const tar = require("tar");
const through2 = require("through2");
const amqp = require("amqplib");
const execa = require("execa");
const run = require("./run");
const { Match } = require("mm-schemas")(mongoose);

const RABBITMQ_URI = process.env.RABBITMQ_URI || "amqp://localhost";
const DOCKER_CREDENTIALS_PATH = "/gcr/mechmania2017-key.json";
const RUNNER_QUEUE = `runnerQueue`;
const GAME_PATH = "/game/game.exe";
const MAP_PATH = "/game/Map.json";

mongoose.connect(process.env.MONGO_URL);
mongoose.Promise = global.Promise;

const s3 = new AWS.S3({
  params: { Bucket: "mechmania" }
});

const getObject = promisify(s3.getObject.bind(s3));
const upload = promisify(s3.upload.bind(s3));
const mkdir = promisify(fs.mkdir);
const readdir = promisify(fs.readdir);
const access = promisify(fs.access);

async function main() {
  // Login to docker
  // docker login -u _json_key --password-stdin https://gcr.io
  const dockerLoginProc = execa("docker", [
    "login",
    "-u",
    "_json_key",
    "--password-stdin",
    "https://gcr.io"
  ]);
  fs.createReadStream(DOCKER_CREDENTIALS_PATH).pipe(dockerLoginProc.stdin);
  const { stdout, stderr } = dockerLoginProc;
  stdout.pipe(process.stdout);
  stderr.pipe(process.stderr);
  await dockerLoginProc;

  const conn = await amqp.connect(RABBITMQ_URI);
  const ch = await conn.createChannel();
  ch.assertQueue(RUNNER_QUEUE, { durable: true });
  ch.prefetch(1);
  process.on("SIGTERM", async () => {
    console.log("Got SIGTERM");
    await ch.close();
    conn.close();
  });

  console.log(`Listening to ${RUNNER_QUEUE}`);
  ch.consume(
    RUNNER_QUEUE,
    async message => {
      console.log(`Got message - ${message.content.toString()}`);
      const [p1, p2] = JSON.parse(message.content.toString()).sort();
      const images = [p1, p2].map(id => `gcr.io/mechmania2017/${id}`);
      const matchName = `logs/${p1}:${p2}`;

      // Pull docker images
      console.log(`${p1} v ${p2} - Fetching docker images`);
      await Promise.all(images.map(img => run("docker", ["pull", img])));

      console.log(`${p1} v ${p2} - Running game`);
      try {
        const { stdout, stderr } = await run(GAME_PATH, [
          ...images.map(img => `docker run --rm -i ${img}`),
          MAP_PATH
        ]);
        // TODO: Save the stderr somewhere too so we have debug infor for each run?
        console.log(`${p1} v ${p2} - Uploading logfile to s3`);
        const data = await upload({
          Key: matchName,
          Body: stdout
        });
        console.log(`${p1} v ${p2} - Uploaded to s3 (${data.Location})`);

        console.log(`${p1} v ${p2} - Parsing logfile for stats`);
        const lastRecord = stdout.split("\n").slice(0, -1)[0];
        console.log(`${p1} v ${p2} - Last log line is ${lastRecord}`);
        const { Winner: winner } = JSON.parse(lastRecord);
        console.log(`${p1} v ${p2} - Winner is ${winner}`);

        console.log(`${p1} v ${p2} - Creating mongo record`);
        const match = new Match({
          key: matchName,
          winner
        });
        console.log(`${p1} v ${p2} - Saving mongo record`);
        await match.save();
      } catch (e) {
        console.log(`${p1} v ${p2} - The game engine exited`);
        console.error(e);

        console.log(`${p1} v ${p2} - Considering the game a tie`);
        console.log(`${p1} v ${p2} - Creating mongo record`);
        const match = new Match({
          key: matchName,
          winner: 3
        });
        console.log(`${p1} v ${p2} - Saving mongo record`);
        await match.save();
      }

      ch.ack(message);
    },
    { noAck: false }
  );
}
main().catch(console.trace);
