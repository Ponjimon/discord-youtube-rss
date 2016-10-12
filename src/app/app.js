import FeedParser from 'feedparser';
import Discord from 'discord.io';
import Hapi from 'hapi';
import stream from 'stream';
import rp from 'request-promise';

export default class Bot {

    constructor(props) {
        if (!props.discord || (props.discord && (!props.discord.token || !props.discord.channelID))) {
            throw new Error('Invalid Discord Config. Aborting.');
        }

        if (!props.callback) {
            throw new Error('No callback URL given. Aborting.');
        }

        this.props = props;

        this.bot = new Discord.Client({
            autorun: true,
            token: props.discord.token,
        });

        this.topics = [];
        this.posted = [];

        this.connect();
    }

    connect() {
        this.bot.on('ready', () => {
            this.startHapi();

            for (const channel in this.bot.channels) {
                if (this.bot.channels[channel].topic) {
                    this.parseTopic(this.bot.channels[channel].topic, this.bot.channels[channel]);
                }
            }
        }).on('debug', rawEvent => {
            this.handleDiscordEvents(rawEvent);
        }).on('disconnected', () => {
            throw new Error('Discord has been disconnected.');
        });
    }

    handleDiscordEvents(event) {
        const data = event.d;
        if (event.t === 'CHANNEL_UPDATE' || event.t === 'CHANNEL_CREATE') {
            if (!data.topic) {
                return;
            }
            this.parseTopic(data.topic, this.bot.channels[data.id]);
            return;
        }

        if (event.t === 'CHANNEL_DELETE') {
            const target = this.topics.find(topic => topic.channelID === data.id);
            if (target) {
                this.unsubscribeFromTopic(target);
            }
        }
    }

    parseTopic(topic, channel) {
        const regex = /https:\/\/www\.youtube\.com\/xml\/feeds\/videos\.xml\?channel_id=.*?/g;
        const parsed = topic.split('#');
        let mentionEveryone = false;
        if (parsed.length > 0) {
            const url = parsed[0];
            if (regex.test(url)) {
                if (parsed.length > 1 && parsed[1] === 'true') {
                    mentionEveryone = true;
                }

                this.subscribeToTopic(url).then(() => {
                    const target = this.topics.find(targetTopic => targetTopic.channelID === channel.id);
                    if (!target) {
                        this.topics.push({ topic: url, channelID: channel.id, mentionEveryone });
                    } else {
                        target.topic = url;
                        target.channelID = channel.id;
                        target.mentionEveryone = mentionEveryone;
                    }
                }).catch(() => {
                    throw new Error('There was an error subscribing to the feed URL.');
                });
            }
        }
    }

    subscribeToTopic(url, unsubscribe) {
        return rp({
            method: 'POST',
            uri: 'https://pubsubhubbub.appspot.com/subscribe',
            form: {
                'hub.callback': this.props.callback,
                'hub.topic': url,
                'hub.verify': 'async',
                'hub.mode': unsubscribe ? 'unsubscribe' : 'subscribe',
            },
        });
    }

    unsubscribeFromTopic(topic) {
        this.subscribeToTopic(topic.topic, true).then(() => {
            this.topics.splice(this.topics.indexOf(topic), 1);
        }).catch(() => {
            throw new Error('There was an error unsubscribing from feed URL.');
        });
    }

    startHapi() {
        const server = new Hapi.Server();
        server.connection({
            port: this.props.port || 3000,
        });

        server.route({
            method: 'POST',
            path: '/',
            config: {
                cors: true,
                payload: {
                    parse: false,
                },
                handler: (req, res) => {
                    const bufferStream = new stream.PassThrough();
                    const parser = new FeedParser();

                    bufferStream.end(new Buffer(req.payload));
                    bufferStream.pipe(parser);

                    parser.on('error', () => {
                        throw new Error('There was an error parsing the feed URL.');
                    });

                    parser.on('readable', () => {
                        const item = parser.read();

                        const target = this.topics.find(topic => topic.url === item.xmlUrl);

                        if (target) {
                            this.sendMessage(item, target);
                        }
                    });
                    return res('Ok.');
                },
            },
        });

        server.start(err => {
            if (err) {
                throw new Error(err);
            }
        });
    }

    sendMessage(video, topic) {
        if (this.posted.indexOf(video.guid) === -1) {
            this.bot.sendMessage({
                to: topic.channelID,
                message: topic.mentionEveryone ? `@everyone ${video.link}` : `${video.link}`,
            });
            return;
        }

        this.posted.push(video.guid);
    }
}
