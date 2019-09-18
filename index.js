const { promisify } = require("util");

const mongoose = require("mongoose");
const AWS = require("aws-sdk");
const fs = require("fs");
const path = require("path");
const tar = require("tar");
const through2 = require("through2");
const amqp = require("amqplib");
const execa = require("execa");
const run = require("./run");
const { Team, Match, Script } = require("mm-schemas")(mongoose);

const RABBITMQ_URI = process.env.RABBITMQ_URI || "amqp://localhost";
const RUNNER_QUEUE = `runnerQueue`;
const GAME_ENGINE_DIR = path.join(__dirname, "mm25_game_engine");

mongoose.connect(process.env.MONGO_URL);
mongoose.Promise = global.Promise;

const s3 = new AWS.S3({
  params: { Bucket: "mechmania2019" }
});

const upload = promisify(s3.upload.bind(s3));

async function main() {
  const conn = await amqp.connect(RABBITMQ_URI);
  const ch = await conn.createChannel();
  ch.assertQueue(RUNNER_QUEUE, { durable: true });
  ch.prefetch(2); // Each instance can run upto 2 games in parallel
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
      const matchName = `logs/${p1}:${p2}`;

      console.log(`${p1} v ${p2} - Getting script data for these IDs`);
      const [script1, script2] = await Promise.all(
        [p1, p2].map(id =>
          Script.findOne({
            key: id
          }).exec()
        )
      );

      console.log(`${p1} v ${p2} - Fetching owners of these scripts`);
      const [owner1, owner2] = await Promise.all(
        [scrtip1, scrtip2].map(owner => 
          Team.findOne({
            _id: owner
          }).exec()
        )
      );

      if (script1._id !== owner1.latestScript || script2._id !== owner2.latestScript) {
        console.log(`${p1} v ${p2} match aborted; current scripts are not the latest scripts`);
      } else {
        console.log(
          `${p1} v ${p2} - Got more data. IPs ${script1.ip} v ${script2.ip}`
        );
        try {
          // java -jar GameEngine.jar [gameId] [boardFile] [player1Name] [player2Name] [player1URL] [player2URL] STDOUT
          const { stdout, stderr } = await execa("java", [
            "-jar",
            path.join(GAME_ENGINE_DIR, "target", "GameEngine.jar"),
            `${p1}:${p2}`,
            path.join(GAME_ENGINE_DIR, "board.csv"),
            "Red", // TODO: fix
            "Blue", // TODO: fix
            `http://${script1.ip}:80/`,
            `http://${script2.ip}:80/`,
            "STDOUT"
          ]);
          // TODO: Save the stderr somewhere too so we have debug infor for each run?
  
          console.log("STDOUT");
          console.log(stdout);
          console.log("STDERR");
          console.log(stderr);
  
          console.log(`${p1} v ${p2} - Uploading logfile to s3`);
          const data = await upload({
            Key: matchName,
            Body: stdout
          });
          console.log(`${p1} v ${p2} - Uploaded to s3 (${data.Location})`);
  
          console.log(`${p1} v ${p2} - Parsing logfile for stats`);
          const logLines = stdout.split("\n");
          const numLogLines = logLines.length; // -1 becuause the last line is just '\n'
          const lastRecord = logLines.slice(-1)[0];
          console.log(`${p1} v ${p2} - Last log line is ${lastRecord}`);
          const { Winner: winner } = JSON.parse(lastRecord);
          console.log(`${p1} v ${p2} - Winner is ${winner}`);
  
          console.log(`${p1} v ${p2} - Creating mongo record`);
          await Match.update(
            {
              key: matchName
            },
            {
              key: matchName,
              length: numLogLines,
              winner
            },
            { upsert: true }
          ).exec();
        } catch (e) {
          console.log(`${p1} v ${p2} - The game engine exited`);
          console.error(e);
  
          console.log(`${p1} v ${p2} - Considering the game a tie`);
          console.log(`${p1} v ${p2} - Creating mongo record`);
          const match = new Match({
            key: matchName,
            winner: 0
          });
          console.log(`${p1} v ${p2} - Saving mongo record`);
          await match.save();
        }
      }
      
      ch.ack(message);
    },
    { noAck: false }
  );
}
main().catch(console.trace);
