| Тип референса               | Что задаёт                                                       |
| --------------------------- | ---------------------------------------------------------------- |
| Изображение (`<Picture N>`) | Внешность, композиция, ракурс, освещение, стиль, реквизит        |
| Видео (`<Video N>`)         | Движение, путь камеры, сцены, ритм, временная структура          |
| Аудио (`<Audio N>`)         | Тембр голоса, диалог/лирики, звуковые эффекты, музыкальный стиль |

### Шестисекционная структура промпта (Ref2VA)

1. `subject_definitions` — референсные активы и метки
2. `summary` — краткое описание задачи и связей
3. `retention_analysis` — что сохраняется / изменяется
4. `detailed_description` — кадры по порядку воспроизведения
5. `overall_soundscape` — атмосфера и физические звуки
6. `non_diegetic_music` — фоновая музыка (или "N/A")

> Все секции на английском (кроме диалогов в `<d>` и видимого текста).

### Метки референсов

- `<Subject N>` — видимое содержимое, абстрагированное из рефов
- `<Picture N>` — изображение-якорь (кадр/композиция/стиль)
- `<Video N>` — видео как источник движения/камеры/монтажа
- `<Audio N>` — аудио для голоса/звука/музыки

**Правило «одна роль»:** каждому активу — одна главная задача.

### Правила нумерации

- `<Video N>` и `<Audio N>` нумеруются **независимо**.
- Изображение для определения персонажа → указывайте внутри `<Subject N>`, отдельная строка `<Picture N>` не нужна.

### Relationship markers

Видимое: `fully_preserved` | `weak_reference`
Аудио: `fully_copy` | `reference` | `weak_reference`

### Говорящие персонажи

- Глобальный ID `(Sx)` на каждом вокальном событии.
- `<Audio N>` для говорящего переиспользует тот же `(Sx)`.
- Не пишите `(Sx)` в `retention_analysis`.

### Пример структуры (Ref2VA) — реальные промпты должны быть значительно подробнее

Референсы: 2 изображения + 1 аудио.

```text
subject_definitions:
<Subject 1> is the coffee-shop interior in <Picture 1> — brick wall, orange sofa, neon sign.
<Subject 2> is the blonde woman in <Picture 2> — long blonde hair, pink shirt.
<Audio 1> is the voice-timbre reference for <Subject 2> (S1).

summary:
[reference generation] <Subject 2> eats a cookie in <Subject 1>, startled by a dog.

retention_analysis:
<Subject 1> ([Shot 1]): fully_preserved — brick wall, orange sofa, neon sign retained.
<Subject 2> ([Shot 1]): fully_preserved — blonde hair, pink shirt retained.
<Audio 1>: reference — vocal timbre guides <Subject 2>'s delivery.

detailed_description:
[Shot 1] Medium shot in <Subject 1>. <Subject 2> (S1) sits on the sofa holding a cookie. A Samoyed lunges at her hand. <Subject 2> (S1) says with light annoyance: <d>[English] Hey! Watch your dog!</d>

overall_soundscape:
Soft indoor coffee-shop room tone.

non_diegetic_music:
N/A
```