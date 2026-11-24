const $ = (selector) => document.querySelector(selector);

const cfg = window.SANTA_CONFIG || {};
const toast = $('#toast');

let db;
let user;
let game;
let me = null;

let isOwner = false;
let isAdmin = false;
let refreshTimer;
let realtimeChannel;

function note(message) {
    if (!toast) {
        console.log(message);
        return;
    }

    toast.textContent = message;
    toast.classList.add('show');

    clearTimeout(note.timer);
    note.timer = setTimeout(() => {
        toast.classList.remove('show');
    }, 3500);
}

function money(value) {
    return new Intl.NumberFormat('ru-RU').format(value || 0);
}

function code() {
    return new URLSearchParams(location.search)
        .get('game')?.toUpperCase();
}

function showSetup() {
    $('#setup-dialog')?.showModal();
}

async function session() {
    const { data, error } = await db.auth.getSession();

    if (error) throw error;

    if (!data.session) {
        const result = await db.auth.signInAnonymously();

        if (result.error) throw result.error;
    }

    const result = await db.auth.getUser();

    if (result.error) throw result.error;

    user = result.data.user;

    if (!user) {
        throw new Error('Не удалось авторизоваться.');
    }
}

async function getGame() {
    const inviteCode = code();

    if (!inviteCode) {
        throw new Error('Не указан код игры.');
    }

    const { data: gameData, error } = await db
        .from('games')
        .select('*')
        .eq('invite_code', inviteCode)
        .single();

    if (error) throw error;

    game = gameData;

    isOwner = game.owner_id === user.id;

    const { data: admins, error: adminError } = await db
        .from('game_admins')
        .select('user_id')
        .eq('game_id', game.id)
        .eq('user_id', user.id);

    if (adminError) throw adminError;

    isAdmin = isOwner || Boolean(admins?.length);

    const { data: member, error: memberError } = await db
        .from('participants')
        .select('id,name')
        .eq('game_id', game.id)
        .eq('user_id', user.id)
        .maybeSingle();

    if (memberError) throw memberError;

    me = member || null;
}

async function refresh() {
    if (!game && !code()) return;

    try {
        await getGame();

        const { data: people, error } = await db
            .from('participants')
            .select('id,name,user_id')
            .eq('game_id', game.id)
            .order('created_at');

        if (error) throw error;

        render(people || []);

        if (game.is_drawn && me) {
            await ownResult();
        }

        if (game.is_drawn && isAdmin) {
            await adminResults();
        }
    } catch (error) {
        console.error(error);
        note(error.message || 'Не удалось загрузить игру.');
    }
}

function render(people) {
    $('#participant-count').textContent = people.length;

    $('#capacity-display').textContent = game.capacity;
    $('#budget-display').textContent = money(game.budget);

    $('.overview-heading h2').textContent = game.title;

    $('#game-status').textContent = game.is_drawn
        ? 'Жеребьёвка завершена'
        : `Свободно мест: ${Math.max(0, game.capacity - people.length)}`;

    $('#current-user').textContent = isOwner
        ? 'Управление игрой'
        : isAdmin
            ? 'Администратор'
            : 'Участник';

    $('#settings-open').hidden = !isAdmin;

    $('#people-list').innerHTML = people.length
        ? people.map(person => `
            <div class="person">
                <div class="person-info">
                    <span class="avatar">
                        ${person.name.split(' ')
                            .map(part => part[0])
                            .join('')
                            .slice(0, 2)}
                    </span>
                    <span>${escapeHTML(person.name)}</span>
                    ${isAdmin ? '<span class="role">участник</span>' : ''}
                </div>
            </div>
        `).join('')
        : '<p class="panel-copy">Пока участников нет.</p>';

    const disabled =
        Boolean(me) ||
        game.is_drawn ||
        people.length >= game.capacity;

    $('#join-button').disabled = disabled;
    $('#join-name').disabled = disabled;
    $('#join-wish').disabled = disabled;

    $('#registration-message').textContent = me
        ? 'Вы уже зарегистрированы. Ваше желание скрыто.'
        : game.is_drawn
            ? 'Игра уже началась.'
            : people.length >= game.capacity
                ? 'Регистрация завершена.'
                : '';
}

function escapeHTML(value) {
    return String(value).replace(/[&<>"']/g, character => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    })[character]);
}

async function ownResult() {
    if (!me) return;

    const { data: pair, error } = await db
        .from('assignments')
        .select('recipient_id')
        .eq('game_id', game.id)
        .eq('giver_id', me.id)
        .maybeSingle();

    if (error) throw error;
    if (!pair) return;

    const { data: recipient, error: recipientError } = await db
        .from('participants')
        .select('name')
        .eq('id', pair.recipient_id)
        .single();

    if (recipientError) throw recipientError;

    $('#my-result-content').innerHTML = `
        <p class="panel-copy">Вам нужно подготовить подарок для</p>
        <h2>${escapeHTML(recipient.name)}</h2>
        <p class="panel-copy">
            Лимит подарка: до ${money(game.budget)} ₽.
        </p>
    `;

    $('#my-result').hidden = false;
}

async function adminResults() {
    const [
        { data: pairs, error: pairsError },
        { data: people, error: peopleError },
        { data: wishes, error: wishesError }
    ] = await Promise.all([
        db.from('assignments')
            .select('giver_id,recipient_id')
            .eq('game_id', game.id),

        db.from('participants')
            .select('id,name')
            .eq('game_id', game.id),

        db.from('wishes')
            .select('participant_id,text')
            .eq('game_id', game.id)
    ]);

    if (pairsError) throw pairsError;
    if (peopleError) throw peopleError;
    if (wishesError) throw wishesError;

    const names = Object.fromEntries(
        (people || []).map(person => [person.id, person.name])
    );

    const wishesByPerson = Object.fromEntries(
        (wishes || []).map(wish => [wish.participant_id, wish.text])
    );

    $('#results-list').innerHTML = (pairs || []).map(pair => `
        <div class="result">
            <div>
                <strong>${escapeHTML(names[pair.giver_id] || 'Участник')}</strong>
                <small>дарит подарок</small>
            </div>

            <span>→</span>

            <div>
                <strong>${escapeHTML(names[pair.recipient_id] || 'Участник')}</strong>
                <small>
                    Желание: ${escapeHTML(wishesByPerson[pair.recipient_id] || '—')}
                </small>
            </div>
        </div>
    `).join('');
}

async function join(event) {
    event.preventDefault();

    if (me || game.is_drawn) return;

    const name = $('#join-name').value.trim();
    const wish = $('#join-wish').value.trim();

    if (!name) {
        return note('Введите своё имя.');
    }

    const { data: person, error } = await db
        .from('participants')
        .insert({
            game_id: game.id,
            user_id: user.id,
            name
        })
        .select('id')
        .single();

    if (error) {
        return note(error.message);
    }

    const { error: wishError } = await db
        .from('wishes')
        .insert({
            game_id: game.id,
            participant_id: person.id,
            text: wish
        });

    if (wishError) {
        console.error(wishError);
        note('Вы зарегистрированы, но желание не сохранилось: ' + wishError.message);
        await refresh();
        return;
    }

    note('Вы успешно зарегистрированы!');
    await refresh();
}

async function createGame(event) {
    event.preventDefault();

    try {
        const title =
            $('#game-title-input').value.trim() || 'Тайный Санта';

        const capacity = Number($('#new-capacity-input').value);
        const budget = Number($('#new-budget-input').value);

        if (!Number.isInteger(capacity) || capacity < 2) {
            return note('Количество участников должно быть не меньше двух.');
        }

        if (!Number.isFinite(budget) || budget < 0) {
            return note('Укажите корректный бюджет.');
        }

        const inviteCode = crypto
            .getRandomValues(new Uint32Array(2))
            .map(number => number.toString(36))
            .join('')
            .slice(0, 8)
            .toUpperCase();

        const { data, error } = await db
            .from('games')
            .insert({
                title,
                capacity,
                budget,
                invite_code: inviteCode,
                owner_id: user.id
            })
            .select()
            .single();

        if (error) throw error;

        note('Игра создана!');

        location.replace(
            `${location.pathname}?game=${encodeURIComponent(data.invite_code)}`
        );
    } catch (error) {
        console.error(error);
        note(error.message || 'Не удалось создать игру.');
    }
}

async function openSettings() {
    if (!isAdmin) return;

    $('#budget-input').value = game.budget;
    $('#capacity-input').value = game.capacity;

    const { data: admins, error: adminError } = await db
        .from('game_admins')
        .select('user_id')
        .eq('game_id', game.id);

    if (adminError) return note(adminError.message);

    const ids = new Set((admins || []).map(item => item.user_id));

    const { data: people, error } = await db
        .from('participants')
        .select('id,name,user_id')
        .eq('game_id', game.id);

    if (error) return note(error.message);

    $('#admins-list').innerHTML = (people || []).map(person => `
        <div class="admin-person">
            <span>${escapeHTML(person.name)}</span>

            ${isOwner
                ? `
                    <label class="switch">
                        <input
                            type="checkbox"
                            data-admin-user="${person.user_id}"
                            ${ids.has(person.user_id) ? 'checked' : ''}
                        />
                        <span class="slider"></span>
                    </label>
                `
                : ids.has(person.user_id)
                    ? '<span class="role">админ</span>'
                    : ''
            }
        </div>
    `).join('') || '<p class="panel-copy">Пока нет участников.</p>';

    $('#settings-dialog').showModal();
}

async function saveSettings(event) {
    if (event.submitter && event.submitter.value !== 'save') return;

    event.preventDefault();

    if (!isAdmin) return;

    const capacity = Number($('#capacity-input').value);
    const budget = Number($('#budget-input').value);

    if (!Number.isInteger(capacity) || capacity < 2) {
        return note('Количество участников должно быть не меньше двух.');
    }

    if (!Number.isFinite(budget) || budget < 0) {
        return note('Укажите корректный бюджет.');
    }

    const { error } = await db
        .from('games')
        .update({ capacity, budget })
        .eq('id', game.id);

    if (error) return note(error.message);

    $('#settings-dialog').close();

    note('Настройки сохранены.');

    await refresh();
}

async function setAdmin(event) {
    if (!isOwner) return;

    const input = event.target;

    if (!input.matches('[data-admin-user]')) return;

    const user_id = input.dataset.adminUser;
    const checked = input.checked;

    const query = checked
        ? db.from('game_admins').insert({
            game_id: game.id,
            user_id
        })
        : db.from('game_admins')
            .delete()
            .eq('game_id', game.id)
            .eq('user_id', user_id);

    const { error } = await query;

    if (error) {
        note(error.message);
        input.checked = !checked;
    } else {
        note(checked
            ? 'Администратор назначен.'
            : 'Права администратора сняты.'
        );
    }
}

function subscribe() {
    if (realtimeChannel) {
        db.removeChannel(realtimeChannel);
    }

    const later = () => {
        clearTimeout(refreshTimer);
        refreshTimer = setTimeout(refresh, 300);
    };

    realtimeChannel = db
        .channel(`game-${game.id}`)
        .on('postgres_changes', {
            event: '*',
            schema: 'public',
            table: 'games',
            filter: `id=eq.${game.id}`
        }, later)
        .on('postgres_changes', {
            event: '*',
            schema: 'public',
            table: 'participants',
            filter: `game_id=eq.${game.id}`
        }, later)
        .on('postgres_changes', {
            event: '*',
            schema: 'public',
            table: 'wishes',
            filter: `game_id=eq.${game.id}`
        }, later)
        .on('postgres_changes', {
            event: '*',
            schema: 'public',
            table: 'assignments',
            filter: `game_id=eq.${game.id}`
        }, later)
        .on('postgres_changes', {
            event: '*',
            schema: 'public',
            table: 'game_admins',
            filter: `game_id=eq.${game.id}`
        }, later)
        .subscribe();
}

async function init() {
    try {
        if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) {
            return note('Заполните config.js данными Supabase.');
        }

        db = window.supabase.createClient(
            cfg.supabaseUrl,
            cfg.supabaseAnonKey
        );

        await session();

        if (!code()) {
            showSetup();
            return;
        }

        await refresh();

        if (game) {
            subscribe();
        }
    } catch (error) {
        console.error(error);
        note(error.message || 'Ошибка запуска приложения.');
    }
}

$('#join-form')?.addEventListener('submit', join);

$('#create-game-form')?.addEventListener('submit', createGame);

$('#settings-open')?.addEventListener('click', openSettings);

$('#settings-form')?.addEventListener('submit', saveSettings);

$('#admins-list')?.addEventListener('change', setAdmin);

$('#results-open')?.addEventListener('click', () => {
    $('#results-dialog')?.showModal();
});

$('#results-close')?.addEventListener('click', () => {
    $('#results-dialog')?.close();
});

init();
