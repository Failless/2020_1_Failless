'use strict';

import ChatModel from 'Eventum/models/chat-model';
import ChatView from 'Eventum/views/chat-view';
import Controller from 'Eventum/core/controller';
import Router from 'Eventum/core/router';
import UserModel from 'Eventum/models/user-model';
import {resizeTextArea} from 'Eventum/utils/basic';
import {toggleChatOnMobile} from 'Blocks/chat/chat';
import {setChatListItemAsRead, toggleChatListItemActive} from 'Blocks/chat-list-item/chat-list-item';
import {detectMobile} from 'Eventum/utils/basic';
import {CircleRedirect} from 'Blocks/circle/circle';
import NotificationController from 'Eventum/controllers/notification-controller';
import TextConstants from 'Eventum/utils/language/text';
import Snackbar from 'Blocks/snackbar/snackbar';

/**
 * @class ChatController
 */
export default class ChatController extends Controller {
    constructor(parent) {
        super(parent);
        this.view = new ChatView(parent);
        this.chat_id = null;
        this.ChatModel = ChatModel.instance;
        this.timerId = null;
        this.active_page = false;
    }

    destructor() {
        this.view.destructor();
        // все чаты неактивны 
        this.ChatModel.chats.forEach((chat, chatId) => {
            if (chat.active) {
                chat.active = false;
            }
        });
        this.active_page = false;
        // this.timerId = null;
        super.destructor();
    }

    action() {
        super.action();
        UserModel.getProfile()
            .then(user => {
                if (user) {
                    this.view.render();
                    this.view.setDOMChatElements(); // do it once instead of calling getters and checking there
                    this.initHandlers([
                        {
                            attr: 'circleRedirect',
                            events: [
                                {type: 'click', handler: CircleRedirect},
                            ]
                        },
                        {
                            attr: 'activateChatListItem',
                            events: [
                                {type: 'click', handler: this.#activateChatListItem},
                            ]
                        },
                        {
                            attr: 'sendMessageOnClick',
                            many: true,
                            events: [
                                {type: 'click', handler: this.#sendMessage},
                            ]
                        },
                        {
                            attr: 'messageInput',
                            events: [
                                {type: 'input', handler: resizeTextArea},
                                {type: 'keydown', handler: (event) => {
                                    if (event.code === 'Enter') {
                                        event.preventDefault();
                                        this.#sendMessage();
                                    }
                                }},
                            ]
                        },
                        {   // mobile only
                            attr: 'toggleMobileChat',
                            events: [
                                {type: 'click', handler: () => {
                                    toggleChatListItemActive(this.view.chatListBody.querySelector('.chat-list-item_active')).then();
                                    toggleChatOnMobile.call(this.view.mainColumn);
                                }},
                            ]
                        },
                    ]);
                    this.ChatModel.getChats({uid: user.uid, limit: 10, page: 0})
                        .then(chats => {
                            if (!chats || chats.length === 0) {
                                const errorArea = detectMobile() ? this.view.chatListBodyDiv : this.view.chatBodyDiv;
                                this.view.renderEmptyList(errorArea).then(() => {
                                    this.addEventHandler(
                                        errorArea.querySelector('button'),
                                        'click',
                                        () => {Router.redirectForward('/feed');}
                                    );
                                });
                            } else if (Object.prototype.hasOwnProperty.call(chats, 'message')) {
                                this.view.showLeftError(chats.message);
                            } else {
                                if (!this.ChatModel.socket) {
                                    this.ChatModel.establishConnection(user.uid, this.receiveMessage).then(
                                        (response) => {
                                            if (!this.timerId) {
                                                this.timerId = setInterval(this.#reestablishConnection, 10000);
                                            }
                                            this.ChatModel.chats = chats;
                                            this.view.renderChatList();
                                            this.active_page = true;
                                        });
                                } else {
                                    this.ChatModel.chats = chats;
                                    this.view.renderChatList();
                                    this.active_page = true;
                                }
                            }
                        },
                        (error) => {
                            this.view.showLeftError(error).then();
                            this.view.showCenterError(error).then();
                            this.ChatModel.socket.close();
                        });
                } else {
                    Snackbar.instance.addMessage(TextConstants.BASIC__ERROR_NO_RIGHTS);
                    setTimeout(() => Router.redirectForward('/'), 1000);
                }})
            .catch(() => {
                Snackbar.instance.addMessage(TextConstants.BASIC__ERROR_NO_RIGHTS);
                setTimeout(() => Router.redirectForward('/'), 1000);
            });
    }

    /**
     * Handle click on chat list item
     *  deactivate previous if exists and activate current
     * @param event
     */
    #activateChatListItem = (event) => {
        event.preventDefault();
        if (event.target.matches('button')) {   // for some reason clicking on 'Искать' button
            return;                             // on error message when the list is empty (mobile only)
        }                                       // triggers this (i hope it's not a footgun)
        const chatListItem = event.target.closest('.chat-list-item');
        const previousChatListItem = this.view.leftColumn.querySelector('.chat-list-item_active');
        if (previousChatListItem && chatListItem.getAttribute('data-cid') === previousChatListItem.getAttribute('data-cid')) {
            return;
        }
        if (previousChatListItem) {
            toggleChatListItemActive(previousChatListItem).then();
        }
        setChatListItemAsRead(chatListItem).then();
        toggleChatListItemActive(chatListItem).then();
        this.#handleChatOpening(
            chatListItem.getAttribute('data-cid'),
            chatListItem.querySelector('.chat-list-item__title').innerText);
        // Но один из чатов становится активным, а другой неактивыным
        this.ChatModel.chats.forEach((chat, chatId) => {
            if (chatId === Number(chatListItem.getAttribute('data-cid'))){
                chat.active = true;
                return;
            }
            if (chat.active) {
                chat.active = false;
            }
        });
    };

    /**
     * Open new WS chat on click on chat in the list
     * @param {String} chatId
     * @param {String} name
     */
    #handleChatOpening = (chatId, name) => {
        // async Render
        // Open websocket connection
        // async Get latest messages
        this.view.renderChatLoading(name).then();
        toggleChatOnMobile.call(this.view.mainColumnDiv);
        let id = 0;
        UserModel.getProfile()
            .then(profile => {
                id = profile.uid;
                return this.ChatModel.getLastMessages(profile.uid, chatId, 30);})
            .then((messages) => {
                this.view.activateChatUI(name).then();
                // Append necessary fields
                messages.forEach((message) => {
                    let chat = this.ChatModel.chats.get(message.chat_id);
                    message.avatar = (message.uid === id || chat.user_count === 2) ? null : chat.users.get(message.uid).avatar;
                    message.side = message.uid === id ? 'right' : 'left';
                    message.new = false;
                    message.body = message.message;
                });
                this.view.renderLastMessages(messages.reverse());})
            .catch(error => this.view.showCenterError(error));
    };

    /***********************************************
                        Chat part
     ***********************************************/

    /**
     * Send message to chat
     */
    #sendMessage = () => {
        let textarea = this.view.chatFooterDiv.querySelector('textarea');

        const message = textarea.value;
        if (!message) {
            return;
        }
        // Send message via WebSocket
        let chat_id = -1;
        // Ищем активный чат
        this.ChatModel.chats.forEach((chat) => {
            if (chat.active === true) {
                chat_id = chat.chat_id;
            }
        });

        UserModel.getProfile()
            .then(profile => this.ChatModel.sendMessage({uid: profile.uid, message: message, chat_id: chat_id}));
        textarea.value = '';
        resizeTextArea.call(textarea);
    };

    /**
     * Re-establish conn to WS with empty message
     */
    #reestablishConnection = () => {
        let chat_id = -1;
        // Ищем активный чат
        this.ChatModel.chats.forEach((chat) => {
            if (chat.active === true) {
                chat_id = chat.chat_id;
            }
        });
        UserModel.getProfile().then(profile => this.ChatModel.sendMessage({uid: profile.uid, message: "", chat_id: chat_id}));
    };

    receiveMessage = (event) => {
        // Find active chat
        let activeChatId = -1;
        for (let [chatId, chat] of this.ChatModel.chats) {
            if (chat.active) {
                activeChatId = chatId;
                break;
            }
        }

        // Check where to insert the message
        let message = JSON.parse(event.data);
        UserModel.getProfile()
            .then(profile => {
                if (message.uid !== profile.uid) {
                    NotificationController.notify(TextConstants.BASIC__NEW_MESSAGE);
                }
                // проверка, чтобы шли уведомления, но не было попытки отобразить
                if (this.active_page) {
                    this.view.updateLastMessage(message, profile.uid === message.uid);
                    if (activeChatId && message.chat_id === activeChatId) {
                        let chat = this.ChatModel.chats.get(message.chat_id);
                        this.view.renderMessage({
                            avatar: (profile.uid === message.uid || chat.user_count === 2) ? null : chat.users.get(message.uid).avatar,
                            body: message.message,
                            side: profile.uid === message.uid ? 'right' : 'left',
                            new: true,
                        });
                    }
                }
            });
    }
}